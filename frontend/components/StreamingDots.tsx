interface Props {
  label: string;
}

export function StreamingDots({ label }: Props) {
  return (
    <div className="flex items-center gap-2 text-gray-400 text-sm">
      <span className="animate-pulse">●</span>
      <span className="animate-pulse" style={{ animationDelay: "150ms" }}>●</span>
      <span className="animate-pulse" style={{ animationDelay: "300ms" }}>●</span>
      <span className="ml-1">{label}</span>
    </div>
  );
}
