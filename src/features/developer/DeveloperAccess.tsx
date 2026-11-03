"use client";
import type { ReactNode } from "react";
import Account from "../auth/Account";
import { useDeveloperAccess } from "./useDeveloperAccess";
import { developerAccessMessages } from "../../services/video/developer-access";
import type { AuthenticatedApi } from "../../services/cloud-library/client";
import type { DeveloperServices } from "../../../server/contracts/developer-services";
export default function DeveloperAccess({
  enabled,
  title,
  disabledMessage,
  children,
}: {
  enabled: boolean;
  title: string;
  disabledMessage?: string;
  children: (access: {
    api: AuthenticatedApi;
    owner: string;
    services: DeveloperServices;
  }) => ReactNode;
}) {
  const access = useDeveloperAccess(enabled);
  const ready = access.state === "ready",
    base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  if (!enabled)
    return (
      <main>
        <h1>{title}</h1>
        <p role="status">
          {disabledMessage ?? developerAccessMessages.disabled}
        </p>
      </main>
    );
  return (
    <div className="developer-access">
      <style>{`.developer-access{max-width:1100px;margin:auto;padding:12px;overflow-wrap:anywhere}.developer-access nav{display:flex;flex-wrap:wrap;gap:8px}.developer-access nav a,.developer-access button{min-height:44px;min-width:44px;padding:10px}.developer-access input{max-width:100%;box-sizing:border-box}.developer-access fieldset{min-width:0}.developer-access main{min-width:0;max-width:100%;box-sizing:border-box}`}</style>
      <Account />
      <nav aria-label="開発者ナビゲーション">
        <a
          href={`${base}/developer/studio/`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Developer Studioを別タブで開く
        </a>
        <a href={`${base}/`} target="_blank" rel="noopener noreferrer">
          Workflowを別タブで開く
        </a>
      </nav>
      <p>
        元のWorkflowや編集は元のタブに保持されます。タブを切り替えて戻れます。
      </p>
      {!ready && (
        <section aria-label="開発者アクセス確認">
          <h1>{title}</h1>
          <p role="status">{developerAccessMessages[access.state]}</p>
          <button onClick={access.recheck}>開発者権限を再確認</button>
        </section>
      )}
      <div hidden={!ready} inert={!ready ? true : undefined}>
        {access.api && access.owner && (
          <div key={access.owner}>
            {children({
              api: access.api,
              owner: access.owner,
              services: access.services,
            })}
          </div>
        )}
      </div>
    </div>
  );
}
