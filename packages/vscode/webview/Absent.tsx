import { Info } from "lucide-react";

/** Every `why` sentence. An absence is said in words — never a dimmed control, never a zero. */
export function Absent({ children }: { children: React.ReactNode }) {
  return (
    <div className="empty absent" role="note">
      <Info size={14} aria-hidden /> <span>{children}</span>
    </div>
  );
}
