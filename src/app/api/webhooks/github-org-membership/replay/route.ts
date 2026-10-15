import { NextRequest, NextResponse } from "next/server";

import { requireAdmin } from "@/lib/api-auth";
import {
  processGithubOrgMembershipEvent,
  verifyWebhookSignature,
  type GitHubMembershipEvent,
} from "@/app/api/webhooks/github-org-membership/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const session = await requireAdmin("webhook.github_org_membership_replay");
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const body = await request.text();
    const payload = Buffer.from(body, "utf-8");

    const signature = request.headers.get("X-Hub-Signature-256") || undefined;
    const secret = process.env.GITHUB_WEBHOOK_SECRET?.trim();
    if (secret && !verifyWebhookSignature(payload, signature)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const event = JSON.parse(body) as GitHubMembershipEvent;
    const result = await processGithubOrgMembershipEvent(event, request.headers);

    return NextResponse.json(
      {
        status: result.status,
        event: result.event,
      },
      { status: 200 },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Replay failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
