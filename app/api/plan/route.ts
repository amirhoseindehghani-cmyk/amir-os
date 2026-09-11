import { startOfIsoWeek } from "@/lib/date-utils";
import {
  buildPlannerContext,
  deterministicPlan,
  SYSTEM_PROMPT,
} from "@/lib/planner-engine";
import {
  proposalJsonSchema,
  validateProposalAgainstDocument,
  validateProposalShape,
} from "@/lib/proposal-ops";
import type { PlannerApiResponse, ReplanRequest } from "@/lib/planner-types";

export const runtime = "nodejs";

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
// The model request can occasionally need more than 25 seconds during a cold
// start. Keep this below Vercel's function timeout while still failing safely
// and leaving planner state untouched.
const REQUEST_TIMEOUT_MS = 50_000;
const MAX_RESPONSE_TOKENS = 1_400;

function json(body: PlannerApiResponse | Record<string, unknown>, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function failure(
  code: string,
  message: string,
  status: number,
  retryable: boolean,
  requestId?: string,
) {
  return json({ ok: false, error: { code, message, retryable, requestId } }, status);
}

// Single-user app: access control lives in middleware.ts (APP_PASSWORD gate).
async function requireUser() {
  return { id: "amir" };
}

function validateRequest(value: unknown): value is ReplanRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<ReplanRequest>;
  if (request.document?.version !== 7) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(request.currentLocalDate ?? "")) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(request.selectedDate ?? "")) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(request.currentWeekId ?? "")) return false;
  if (!request.timezone || !request.trigger) return false;
  if (request.trigger === "modify" && (!request.originalProposal || !request.modification?.trim())) {
    return false;
  }
  return true;
}

export async function GET() {
  const user = await requireUser();
  if (!user) return failure("UNAUTHORIZED", "Please sign in to use AI planning.", 401, false);

  return json({
    ok: true,
    configured: Boolean(process.env.ANTHROPIC_API_KEY),
    model: process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
  });
}

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const user = await requireUser();
  if (!user) return failure("UNAUTHORIZED", "Please sign in to use AI planning.", 401, false, requestId);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return failure("INVALID_REQUEST", "The planning request was not valid JSON.", 400, false, requestId);
  }

  if (!validateRequest(body)) {
    return failure(
      "INVALID_REQUEST",
      "The planning request is incomplete. Your plan has not changed.",
      400,
      false,
      requestId,
    );
  }

  if (body.currentWeekId !== startOfIsoWeek(body.currentLocalDate)) {
    return failure(
      "STALE_WEEK",
      "The planner week is stale. Refresh the page and try again; your plan has not changed.",
      409,
      true,
      requestId,
    );
  }

  const planningWeekId = startOfIsoWeek(body.selectedDate);
  if (!body.document.weeks.some((week) => week.weekId === planningWeekId)) {
    return failure(
      "MISSING_WEEK",
      "The selected week has not been initialized. Refresh and try again.",
      409,
      true,
      requestId,
    );
  }

  const key = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

  if (!key) {
    if (process.env.NODE_ENV !== "production") {
      const proposal = deterministicPlan(body);
      const validation = validateProposalAgainstDocument(proposal, body.document);
      if (validation.length) {
        return failure("INVALID_PROPOSAL", validation.join(" "), 422, false, requestId);
      }
      return json({
        ok: true,
        proposal,
        meta: { provider: "local-policy", model: "deterministic-development", requestId },
      });
    }

    console.error("[planner-ai] configuration error", { requestId, configured: false });
    return failure(
      "AI_NOT_CONFIGURED",
      "AI planning is not configured. Your existing plan has not been changed.",
      503,
      false,
      requestId,
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        max_tokens: MAX_RESPONSE_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: JSON.stringify(buildPlannerContext(body)) }],
        tools: [
          {
            name: "propose_plan_update",
            description:
              "Return the complete, unapplied planner proposal for Amir to review.",
            input_schema: proposalJsonSchema(),
          },
        ],
        tool_choice: { type: "tool", name: "propose_plan_update" },
      }),
    });

    if (!anthropicResponse.ok) {
      let upstreamType = "unknown";
      try {
        const details = (await anthropicResponse.json()) as { error?: { type?: string } };
        upstreamType = details.error?.type || upstreamType;
      } catch {
        // The response body is intentionally not logged: it can contain request details.
      }
      console.error("[planner-ai] Anthropic request failed", {
        requestId,
        status: anthropicResponse.status,
        upstreamType,
        model,
        elapsedMs: Date.now() - startedAt,
      });
      return failure(
        "AI_PROVIDER_ERROR",
        "AI planning failed. Your existing plan has not been changed.",
        502,
        anthropicResponse.status === 429 || anthropicResponse.status >= 500,
        requestId,
      );
    }

    const result = (await anthropicResponse.json()) as {
      content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }>;
    };
    const toolResult = result.content?.find(
      (item) => item.type === "tool_use" && item.name === "propose_plan_update",
    )?.input;
    const text = result.content?.find((item) => item.type === "text")?.text;
    if (!toolResult && !text) {
      console.error("[planner-ai] Anthropic returned no proposal", { requestId, model });
      return failure(
        "EMPTY_AI_RESPONSE",
        "AI planning returned an empty response. Your plan has not been changed.",
        502,
        true,
        requestId,
      );
    }

    let proposal: unknown;
    if (toolResult) {
      proposal = toolResult;
    } else {
      try {
        proposal = JSON.parse(text!.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
      } catch {
        console.error("[planner-ai] structured response was not JSON", { requestId, model });
        return failure(
          "INVALID_AI_RESPONSE",
          "AI planning returned an unreadable proposal. Your plan has not been changed.",
          502,
          true,
          requestId,
        );
      }
    }

    if (!validateProposalShape(proposal)) {
      console.error("[planner-ai] proposal schema rejected", { requestId });
      return failure(
        "INVALID_AI_RESPONSE",
        "AI planning returned an invalid proposal. Your plan has not been changed.",
        422,
        true,
        requestId,
      );
    }

    if (proposal.selectedDate !== body.selectedDate || proposal.weekId !== planningWeekId) {
      console.error("[planner-ai] proposal context mismatch", {
        requestId,
        expectedDate: body.selectedDate,
        receivedDate: proposal.selectedDate,
        expectedWeek: planningWeekId,
        receivedWeek: proposal.weekId,
      });
      return failure(
        "STALE_AI_RESPONSE",
        "AI planning returned a proposal for the wrong date. Your plan has not been changed.",
        409,
        true,
        requestId,
      );
    }

    const validation = validateProposalAgainstDocument(proposal, body.document);
    if (validation.length) {
      console.error("[planner-ai] proposal safety validation failed", {
        requestId,
        reason: validation.join(" "),
      });
      return failure(
        "UNSAFE_AI_RESPONSE",
        `The proposal could not be safely applied: ${validation.join(" ")}`,
        422,
        true,
        requestId,
      );
    }

    console.info("[planner-ai] proposal generated", {
      requestId,
      trigger: body.trigger,
      selectedDate: body.selectedDate,
      weekId: planningWeekId,
      changeCount: proposal.changes.length,
      model,
      elapsedMs: Date.now() - startedAt,
    });

    return json({
      ok: true,
      proposal,
      meta: { provider: "anthropic", model, requestId },
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    console.error("[planner-ai] request exception", {
      requestId,
      kind: timedOut ? "timeout" : "network_or_runtime",
      elapsedMs: Date.now() - startedAt,
    });
    return failure(
      timedOut ? "AI_TIMEOUT" : "AI_REQUEST_FAILED",
      timedOut
        ? "AI planning timed out. Your existing plan has not been changed."
        : "AI planning failed. Your existing plan has not been changed.",
      timedOut ? 504 : 502,
      true,
      requestId,
    );
  } finally {
    clearTimeout(timeout);
  }
}
