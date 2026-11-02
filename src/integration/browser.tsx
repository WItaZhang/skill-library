import React from "react";
import { createRoot } from "react-dom/client";
import { Product } from "./Product";
import {
  createHttpLibraryClient,
  createSseSkillUpdateSource,
} from "../modules/broadcast/client";
import { DomainError, type Actor, type RuntimeService } from "../contracts";
import "./portfolio.css";
async function rpc(path: string, input: unknown) {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-Skill-Library": "1" },
    body: JSON.stringify(input),
  });
  const data = await response.json();
  if (!response.ok)
    throw new DomainError(
      data.error?.code || "UNAVAILABLE",
      data.error?.message || "请求失败。",
    );
  return data.result;
}
const library = createHttpLibraryClient();
const updateSource = createSseSkillUpdateSource();
const runtime = Object.fromEntries(
  [
    "createSession",
    "createTask",
    "getTask",
    "createChildTask",
    "resolveSkill",
    "recordInvocation",
    "listInvocations",
    "getSessionUpdates",
    "setPreference",
  ].map((method) => [
    method,
    (_actor: Actor, ...args: unknown[]) =>
      rpc(`/api/runtime/${method}`, { args }),
  ]),
) as unknown as RuntimeService;
const root = createRoot(document.getElementById("root")!);
root.render(
  <p className="boot" role="status">
    正在准备你的独立演示工作区…
  </p>,
);
(async () => {
  const { actor } = await rpc("/api/demo/bootstrap", {});
  const key = `skill-library:session:${actor.teamId}`;
  let sessionId = sessionStorage.getItem(key);
  if (!sessionId) {
    sessionId = (await runtime.createSession(actor)).id;
    sessionStorage.setItem(key, sessionId);
  }
  root.render(
    <Product
      actor={actor}
      library={library}
      runtime={runtime}
      updateSource={updateSource}
      initialSessionId={sessionId}
      simulatePublication={async (skillId) => {
        await rpc("/api/demo/publish", { skillId });
      }}
    />,
  );
})().catch((e) =>
  root.render(
    <div className="boot" role="alert">
      <h1>暂时无法打开演示</h1>
      <p>{e.message}</p>
      <button onClick={() => location.reload()}>重试</button>
    </div>,
  ),
);
