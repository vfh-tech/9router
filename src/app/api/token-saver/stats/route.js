import { NextResponse } from "next/server";
import { getTokenSaverStats } from "@/lib/tokenSaver/events.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const recentLimit = Math.min(Number(searchParams.get("limit")) || 100, 500);
    return NextResponse.json(getTokenSaverStats({ recentLimit }));
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}