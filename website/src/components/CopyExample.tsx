import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';

type Props = { text: string };
type State = 'idle' | 'pending' | 'success' | 'failure';
const messages: Record<State, string> = {
  idle: '',
  pending: 'Copying example…',
  success: 'Example copied.',
  failure: 'Unable to copy. Select the reading example and copy it manually. Try again.',
};

export default function CopyExample({ text }: Props) {
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<State>('idle');
  const busy = useRef(false);
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    setReady(true);
    return () => { active.current = false; };
  }, []);

  async function copy() {
    // Synchronous guard prevents repeated activation before React commits state.
    if (busy.current) return;
    busy.current = true;
    setState('pending');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      if (active.current) setState('success');
    } catch {
      if (active.current) setState('failure');
    } finally {
      busy.current = false;
    }
  }

  return (
    <div data-copy-example>
      <Button disabled={!ready} aria-disabled={state === 'pending'}
        onClick={copy}>Copy reading example</Button>
      <p role="status" aria-live="polite" aria-atomic="true">
        {messages[state]}
      </p>
    </div>
  );
}
