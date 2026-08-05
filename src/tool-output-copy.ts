export function selectToolOutputCopyText(
  displayedCandidates: Array<string | null | undefined>,
  fallback: string,
): string {
  return displayedCandidates.find((candidate) => candidate?.trim()) ??
    (fallback.trim() ? fallback : "");
}
