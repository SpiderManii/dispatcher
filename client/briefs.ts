// The light poll every surface outside the page shares: the sidebar count, sidebar row badges, the panel beside a
// session. One query key, so however many rows are on screen there is one request every few seconds.
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { attentionRpc } from "../shared/contracts";

export const ATTENTION_KEY = ["dispatch-center", "attention"] as const;
const POLL_MS = 6_000;

/** Labels plugin-started sessions carry, so a session can be traced to its requirement on the client. */
export const LANE_LABEL = "dispatch-center/lane";
export const DISPATCHER_LABEL = "dispatch-center/dispatcher";
export const ROLE_LABEL = "dispatch-center/role";

export function useAttention() {
  const load = useRpc(attentionRpc);
  return useQuery({
    queryKey: ATTENTION_KEY,
    queryFn: () => load({}),
    refetchInterval: POLL_MS,
    // Back from another window: the user may have handled things in the conversation meanwhile.
    refetchOnWindowFocus: true,
  });
}
