import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";

import { authOptions } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/csrf";
import { prisma } from "@/lib/prisma";
import { captureException } from "@/lib/sentry";
import { type OnboardingChecklistState, parseChecklistState } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_STEP_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_STEPS_ALLOWED = 50;

/**
 * Validate incoming checklist update payload.
 * Prevents PII injection and ensures only valid boolean state is stored.
 */
function validateChecklistPayload(body: unknown): {
  valid: boolean;
  updates: OnboardingChecklistState;
  error?: string;
} {
  if (!body || typeof body !== "object") {
    return { valid: false, updates: {}, error: "Invalid request payload" };
  }

  const payload = body as Record<string, unknown>;
  const updates: OnboardingChecklistState = {};

  // Case 1: Single step toggle { stepId: string, completed: boolean }
  if ("stepId" in payload) {
    const stepId = payload.stepId;
    const completed = payload.completed;

    if (typeof stepId !== "string" || !VALID_STEP_REGEX.test(stepId)) {
      return { valid: false, updates: {}, error: "Invalid stepId format" };
    }
    if (typeof completed !== "boolean") {
      return { valid: false, updates: {}, error: "completed must be a boolean" };
    }

    updates[stepId] = completed;
    return { valid: true, updates };
  }

  // Case 2: Multi-step update { steps: Record<string, boolean> } or { checklistCompleted: Record<string, boolean> }
  const stepsCandidate = (payload.steps ?? payload.checklistCompleted ?? payload) as Record<
    string,
    unknown
  >;

  if (typeof stepsCandidate !== "object" || stepsCandidate === null) {
    return { valid: false, updates: {}, error: "Checklist steps must be an object" };
  }

  const entries = Object.entries(stepsCandidate);
  if (entries.length > MAX_STEPS_ALLOWED) {
    return { valid: false, updates: {}, error: "Too many checklist steps" };
  }

  for (const [key, val] of entries) {
    if (!VALID_STEP_REGEX.test(key)) {
      return { valid: false, updates: {}, error: `Invalid step key: ${key}` };
    }
    if (typeof val !== "boolean") {
      return { valid: false, updates: {}, error: `Value for ${key} must be a boolean` };
    }
    updates[key] = val;
  }

  return { valid: true, updates };
}

/**
 * PATCH /api/register/checklist
 *
 * Persists onboarding checklist step completion for the signed-in user.
 * Merges updates with existing state to prevent multi-tab stomp.
 */
export async function PATCH(request: NextRequest) {
  const csrf = assertSameOrigin(request);
  if (csrf) return csrf;

  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const rawBody = (await request.json().catch(() => null)) as unknown;
    const { valid, updates, error } = validateChecklistPayload(rawBody);

    if (!valid) {
      return NextResponse.json({ error: error ?? "Invalid payload" }, { status: 400 });
    }

    const userId = session.user.id;

    // Fetch existing checklist from user and/or registration
    const [user, registration] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { checklistCompleted: true },
      }),
      prisma.registration.findUnique({
        where: { userId },
        select: { id: true, deletedAt: true, checklistCompleted: true },
      }),
    ]);

    const existingUserChecklist = parseChecklistState(user?.checklistCompleted);
    const existingRegChecklist = parseChecklistState(registration?.checklistCompleted);

    const mergedChecklist: OnboardingChecklistState = {
      ...existingUserChecklist,
      ...existingRegChecklist,
      ...updates,
    };

    // Atomically persist to User and active Registration
    const dbOperations: Array<Promise<unknown>> = [
      prisma.user.update({
        where: { id: userId },
        data: { checklistCompleted: mergedChecklist },
      }),
    ];

    if (registration && !registration.deletedAt) {
      dbOperations.push(
        prisma.registration.update({
          where: { id: registration.id },
          data: { checklistCompleted: mergedChecklist },
        })
      );
    }

    await Promise.all(dbOperations);

    return NextResponse.json({
      success: true,
      checklistCompleted: mergedChecklist,
    });
  } catch (err) {
    captureException(err, {
      route: "/api/register/checklist",
      method: "PATCH",
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "Failed to update checklist" },
      { status: 500 }
    );
  }
}
