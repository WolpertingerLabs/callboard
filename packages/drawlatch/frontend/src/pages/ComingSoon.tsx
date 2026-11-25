interface ComingSoonProps {
  title: string;
}

export default function ComingSoon({ title }: ComingSoonProps) {
  return (
    <>
      <header className="page-header">
        <h1 className="page-title">{title}</h1>
      </header>
      <div className="placeholder">
        <span className="placeholder-title">Coming soon</span>
        <span>This view ships in a follow-up phase.</span>
      </div>
    </>
  );
}
