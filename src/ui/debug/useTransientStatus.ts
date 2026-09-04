// A transient result pill: the outcome of the last command, cleared a few seconds later.
//
// Extracted from StatusPanel (where it was module-private) once a second panel needed it. A third
// inline copy is the kind of duplication this codebase has repeatedly paid for.

import { useEffect, useState } from 'preact/hooks';

/** The text of a command outcome, plus the `.pill` tone class to render it in. */
export interface Status {
  text: string;
  tone: 'green' | 'orange' | 'red';
}

/** A pill status that clears itself a few seconds after it was last set (one per command button). */
export function useTransientStatus(): [Status | null, (status: Status | null) => void] {
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    if (!status) return;
    const id = setTimeout(() => setStatus(null), 5000);
    return () => clearTimeout(id);
  }, [status]);
  return [status, setStatus];
}
