import type { AdminConnectionTemplate } from "drawlatch-admin-types";

export default function StabilityBadge({
  stability,
}: {
  stability: AdminConnectionTemplate["stability"];
}) {
  return (
    <span className={`stability-badge stability-${stability}`}>{stability}</span>
  );
}
