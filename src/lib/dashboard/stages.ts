export const PIPELINE: { key: string; label: string }[] = [
  { key: "researching", label: "Research" },
  { key: "deduplicating", label: "Duplicate check" },
  { key: "fact_checking", label: "Fact-check" },
  { key: "writing", label: "Write" },
  { key: "quality_check", label: "Quality gate" },
  { key: "generating_image", label: "Thumbnail" },
  { key: "publishing", label: "Publish" },
];

export const ACTIVE_STATUSES = ["queued", "researching", "deduplicating", "fact_checking", "writing", "quality_check", "generating_image", "publishing", "retry_scheduled"];
