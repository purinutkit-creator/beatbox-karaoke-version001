import { createRoot } from 'react-dom/client';
import App from './App.jsx';
// default receipt font bundled with the app (printing never depends on an external font CDN)
import '@fontsource/kanit/400.css';
import '@fontsource/kanit/700.css';
import './styles.css';

createRoot(document.getElementById('root')).render(<App />);
