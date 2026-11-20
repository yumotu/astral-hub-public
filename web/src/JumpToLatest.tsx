import { ChevronsDown } from 'lucide-react';
export function JumpToLatest({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="pi-jump-latest" onClick={onClick}>
      <ChevronsDown size={14} />
      回到最新
    </button>
  );
}
