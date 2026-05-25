export type ClarityField = "business_goal" | "business_context" | "task" | "decision";

export interface ClarityResult {
  ok: boolean;
  issues: Partial<Record<ClarityField, string>>;
}

export async function validateClarity(
  fields: Partial<Record<ClarityField, string>>
): Promise<ClarityResult> {
  try {
    const res = await fetch("/api/backend/api/validate-clarity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
    if (!res.ok) return { ok: true, issues: {} };
    const data = await res.json();
    return {
      ok: Boolean(data?.ok),
      issues: (data?.issues ?? {}) as Partial<Record<ClarityField, string>>,
    };
  } catch {
    return { ok: true, issues: {} };
  }
}
