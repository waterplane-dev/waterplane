/**
 * The bell: the one header button onto the feed, on the launcher and on a
 * session's header alike. Its count is what needs the person, and a tap opens
 * exactly those (`openBell`) — a count on a control is a filter.
 */
import { Bell } from "lucide-react";
import { Button } from "../../kit";
import { openBell } from "./actions";
import { badgeText } from "./logic";
import { useUnread } from "./store";

export function BellButton({ size }: { size: number }) {
  const unread = useUnread();
  return (
    <Button className="notif-btn" title={unread > 0 ? `${unread} need you — open exactly those` : "notifications"} onClick={openBell}>
      <Bell size={size} />{unread > 0 && <span className="notif-badge">{badgeText(unread)}</span>}
    </Button>
  );
}
