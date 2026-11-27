import { NextRequest, NextResponse } from "next/server";
import { extractBetsFromImage } from "@/lib/ai/extract";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const file = form.get("image");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Please upload an image." }, { status: 400 });
    }
    if (file.size > 10 * 1024 * 1024) {
      return NextResponse.json({ error: "Image must be smaller than 10 MB." }, { status: 400 });
    }
    const bytes = await file.arrayBuffer();
    const base64 = Buffer.from(bytes).toString("base64");
    const bets = await extractBetsFromImage(base64, file.type || "image/jpeg");
    return NextResponse.json({ bets });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Screenshot extraction failed.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
