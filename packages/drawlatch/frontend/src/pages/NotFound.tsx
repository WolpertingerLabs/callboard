import { Link, useLocation } from "react-router-dom";
import { Compass } from "lucide-react";
import EmptyState from "../components/EmptyState";

export default function NotFound() {
  const { pathname } = useLocation();
  return (
    <>
      <header className="page-header">
        <h1 className="page-title">Page not found</h1>
      </header>
      <EmptyState
        icon={<Compass size={20} />}
        title="There's nothing at this address"
        body={
          <>
            No dashboard page lives at <code className="not-found-path">{pathname}</code>. The
            link may be mistyped, or the page may have moved.
          </>
        }
        action={
          <Link to="/" className="btn btn-primary">
            Go to Overview
          </Link>
        }
      />
    </>
  );
}
