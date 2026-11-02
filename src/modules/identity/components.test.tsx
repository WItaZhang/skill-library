import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  TeamMembers,
  AcceptInvitation,
  IdentityPanel,
  TeamPicker,
} from "./components.tsx";
import type { IdentityClient } from "./types.ts";
const client = {} as IdentityClient;
test("身份组件中文、加载态、权限与邀请呈现", () => {
  assert.match(
    renderToStaticMarkup(<IdentityPanel client={client} />),
    /正在加载账号/,
  );
  assert.match(
    renderToStaticMarkup(<TeamPicker client={client} onSelect={() => {}} />),
    /新团队名称/,
  );
  const admin = renderToStaticMarkup(
    <TeamMembers
      client={client}
      team={{ id: "x", name: "研发", role: "admin" }}
    />,
  );
  assert.match(admin, /邀请邮箱/);
  const viewer = renderToStaticMarkup(
    <TeamMembers
      client={client}
      team={{ id: "x", name: "研发", role: "viewer" }}
    />,
  );
  assert.doesNotMatch(viewer, /邀请邮箱/);
  assert.match(
    renderToStaticMarkup(
      <AcceptInvitation client={client} token="hidden-secret" />,
    ),
    /接受邀请/,
  );
  assert.doesNotMatch(
    renderToStaticMarkup(
      <AcceptInvitation client={client} token="hidden-secret" />,
    ),
    /hidden-secret/,
  );
});
