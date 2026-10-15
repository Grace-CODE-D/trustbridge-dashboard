import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";

import { authOptions } from "@/lib/auth";
import {
  getAllFeatureFlags,
  flagSourceLabel,
} from "@/lib/feature-flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/settings/feature-flags
 *
 * Returns a list of all resolved feature flags with descriptions,
 * resolved statuses (taking into account env overrides and DB state),
 * and human-readable source labels.
 *
 * Restricted to authenticated maintainers.
 */
export async function GET() {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!session.user.isMaintainer) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const resolvedFlags = await getAllFeatureFlags();

  const flags = resolvedFlags.map((flag) => ({
    key: flag.key,
    enabled: flag.enabled,
    value: flag.enabled,
    source: flagSourceLabel(flag.source),
    description: flag.description,
  }));

  return NextResponse.json(
    { flags },
    {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    }
  );
}
