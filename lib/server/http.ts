import { NextResponse } from "next/server";

export function jsonOk<T>(data: T, init: ResponseInit = {}) {
  return NextResponse.json(data, { ...init, status: init.status || 200 });
}

export function jsonError(message: string, status = 400, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

