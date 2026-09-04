import { render } from 'preact';
import '@/ui/debug/debug.css';
import { DebugApp } from '@/ui/debug/DebugApp';

const root = document.getElementById('app');
if (root) render(<DebugApp />, root);
