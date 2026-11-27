import type { AdminConnectionTemplate } from "drawlatch-admin-types";

const TONE: Record<string, string> = {
  stable: "badge-success",
  beta: "badge-warning",
  dev: "badge-accent",
};

export default function StabilityBadge({
  stability,
}: {
  stability: AdminConnectionTemplate["stability"];
}) {
  return (
    <span
      className={`badge ${TONE[stability] ?? "badge-muted"}`}
    >
      {stability}
    </span>
  );
}
