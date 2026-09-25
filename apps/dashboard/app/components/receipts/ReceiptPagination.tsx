import { Link, useLocation, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";

export function ReceiptPagination({ nextCursor, busy }: { nextCursor?: string; busy: boolean }) {
  const location = useLocation();
  const navigate = useNavigate();
  const query = new URLSearchParams(location.search);
  const hasCursor = query.has("cursor");
  query.delete("cursor");
  const first = `${location.pathname}${query.size === 0 ? "" : `?${query}`}`;

  if (nextCursor !== undefined) query.set("cursor", nextCursor);
  const next = `${location.pathname}?${query}`;

  return (
    <nav aria-label="Sider i utleggslisten" className="flex flex-wrap gap-2">
      {hasCursor && (
        <>
          <Button variant="outline" disabled={busy} onClick={() => navigate(-1)}>
            Tilbake
          </Button>
          <Button variant="outline" asChild>
            <Link to={first}>Første side</Link>
          </Button>
        </>
      )}
      {nextCursor !== undefined && (
        <Button variant="outline" asChild>
          <Link to={next}>Neste side</Link>
        </Button>
      )}
    </nav>
  );
}
