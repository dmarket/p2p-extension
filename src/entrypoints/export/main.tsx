import { render } from 'preact';
import '@fontsource/montserrat/latin-400.css';
import '@fontsource/montserrat/latin-600.css';
import '@fontsource/montserrat/latin-700.css';
import '@/ui/popup/popup.css';
import '@/ui/export/export.css';
import { ExportApp } from '@/ui/export/ExportApp';

const root = document.getElementById('app');
if (root) render(<ExportApp />, root);
