/**
 * DSH 主题 token 的**逐值快照**，供「脱离 DSH」的两种形态共用：
 *   - standalone/build.mjs  → 单文件网页版
 *   - desktop/build.mjs     → Electron 桌面版
 *
 * 取值来源：@deepseek-ai/dsh-client-ui-theme 的浅色 / 深色两套主题
 * （alias 层 -> static 色板层逐级解析后的字面值）。
 * 这里只列本组件真正用到的 token；DSH 升级换色时改这一个文件即可。
 *
 * 注意：--dsw-alias-brand-primary 在浅色下是近黑（#0f1115）、深色下是近白（#f9fafb），
 * 所以任何「铺在 brand 上的文字」都必须用 --dsw-alias-label-primary-foreground，
 * 不能硬编码 #fff。
 */
export const DSH_TOKENS_CSS = `/* ---- 浅色（= DSH 浅色主题） ---- */
:root{
  --dsw-alias-bg-base:#fff;
  --dsw-alias-bg-layer-1:#fff;
  --dsw-alias-bg-layer-2:#fff;
  --dsw-alias-bg-layer-3:#fff;
  --dsw-alias-bg-overlay:#e9ecf2;
  --dsw-alias-border-l1:#0000000a;
  --dsw-alias-border-l2:#0000001a;
  --dsw-alias-border-l3:#0000001f;
  --dsw-alias-brand-primary:#0f1115;
  --dsw-alias-button-primary-hover:#43454a;
  --dsw-alias-label-primary:#0f1115;
  --dsw-alias-label-secondary:#61666b;
  --dsw-alias-label-primary-foreground:#fff;
  --dsw-alias-switch-thumb:#fff;
  --dsw-alias-state-business-primary:#4176e6;
  --dsw-alias-state-success-primary:#22c55e;
  --dsw-alias-state-warn-primary:#f59e0b;
  --dsw-alias-state-error-primary:#ec1313;
  --dsw-alias-state-idle-primary:#d4d4d4;
}

/* ---- 深色（= DSH 深色主题） ---- */
@media (prefers-color-scheme: dark){
  :root{
    --dsw-alias-bg-base:#151517;
    --dsw-alias-bg-layer-1:#232324;
    --dsw-alias-bg-layer-2:#2c2c2e;
    --dsw-alias-bg-layer-3:#353638;
    --dsw-alias-bg-overlay:#61666b;
    --dsw-alias-border-l1:#ffffff0f;
    --dsw-alias-border-l2:#ffffff1f;
    --dsw-alias-border-l3:#ffffff29;
    --dsw-alias-brand-primary:#f9fafb;
    --dsw-alias-button-primary-hover:#ebeef2;
    --dsw-alias-label-primary:#f9fafb;
    --dsw-alias-label-secondary:#cfd3d6;
    --dsw-alias-label-primary-foreground:#0f1115;
    --dsw-alias-switch-thumb:#adb2b8;
    --dsw-alias-state-business-primary:#7aaaff;
    --dsw-alias-state-success-primary:#22c55e;
    --dsw-alias-state-warn-primary:#f59e0b;
    --dsw-alias-state-error-primary:#f25a5a;
    --dsw-alias-state-idle-primary:#545557;
  }
}
`;
