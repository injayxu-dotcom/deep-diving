import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
// 令牌必须在组件样式之前引入：styles.css 全程引用其中的变量
import './styles/tokens.css';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
