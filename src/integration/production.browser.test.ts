import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { Pool } from "pg";
import { chromium, expect } from "@playwright/test";
import { createProductionApplication } from "./production-server.ts";
const connectionString = process.env.DATABASE_URL;
test(
  "桌面和窄屏 Chrome：真实 HTTP + PostgreSQL 产品流程（显式测试 OAuth 提供方）",
  { skip: !connectionString, timeout: 60000 },
  async () => {
    const admin = new Pool({ connectionString });
    const schema = "browser_" + randomUUID().replaceAll("-", "");
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({
      connectionString,
      options: `-c search_path=${schema}`,
    });
    const origin = "http://127.0.0.1:18744";
    const app = await createProductionApplication({
      pool,
      publicOrigin: origin,
      mode: "test",
      webDir: "src/modules/product/dist",
      pollIntervalMs: 30,
      testProvider: {
        name: "browser-fixture",
        authorizationUrl: ({ state, redirectUri }) =>
          `${redirectUri}?state=${state}&code=alice`,
        exchange: async ({ code }) => ({
          subject: code,
          displayName: "浏览器测试作者",
          verifiedEmail: `${code}@example.test`,
        }),
      },
    });
    await new Promise<void>((done) =>
      app.server.listen(18744, "127.0.0.1", done),
    );
    const browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.CHROME_PATH ??
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      await page.goto(origin);
      await page.getByRole("link", { name: "使用 GitHub 登录" }).click();
      await page.getByLabel("新团队名称").fill("浏览器验收团队");
      await page.getByRole("button", { name: "创建团队", exact: true }).click();
      await page.getByRole("button", { name: "＋ 新建技能" }).click();
      await page.getByLabel("技能名称", { exact: true }).fill("生产验收技能");
      await page.getByRole("button", { name: "创建并编辑" }).click();
      await page
        .getByRole("textbox", { name: "SKILL.md", exact: true })
        .fill("# 第一版\n\n真实浏览器内容。");
      await page.getByRole("button", { name: "保存草稿", exact: true }).click();
      await expect(page.locator(".save-status")).toContainText("草稿已保存");
      await page.getByLabel("修改说明").fill("浏览器首次发布");
      await page
        .getByRole("button", { name: "提交并生效", exact: true })
        .click();
      await expect(page.getByText("v1 已自动生效")).toBeVisible();
      await page
        .getByRole("button", { name: "← 返回技能详情", exact: true })
        .click();
      await page.getByRole("button", { name: "编辑名称与简介" }).click();
      await page.getByLabel("技能名称", { exact: true }).fill("名称已更新");
      await page.getByRole("button", { name: "保存名称与简介" }).click();
      await expect(
        page.getByRole("heading", { name: "名称已更新", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "使用技能", exact: true }).click();
      await page.getByRole("button", { name: "载入技能", exact: true }).click();
      await expect(page.getByText("技能已载入，版本已固定。")).toBeVisible();
      await page
        .getByRole("navigation", { name: "主导航" })
        .getByRole("button", { name: /技能库/ })
        .click();
      await page.getByRole("button", { name: /名称已更新/ }).click();
      await page.getByRole("button", { name: "编辑技能", exact: true }).click();
      await page
        .getByRole("textbox", { name: "SKILL.md", exact: true })
        .fill("# 第二版\n\n保留历史。");
      const dismiss = (dialog: any) => void dialog.dismiss();
      page.once("dialog", dismiss);
      await page.getByRole("button", { name: "← 返回技能详情" }).click();
      await expect(
        page.getByRole("textbox", { name: "SKILL.md", exact: true }),
      ).toHaveValue("# 第二版\n\n保留历史。");
      await page.getByRole("button", { name: "保存草稿", exact: true }).click();
      await expect(page.locator(".save-status")).toContainText("草稿已保存");
      await page.getByLabel("修改说明").fill("第二次发布");
      await page
        .getByRole("button", { name: "提交并生效", exact: true })
        .click();
      await expect(page.getByText("v2 已自动生效")).toBeVisible();
      await page
        .getByRole("button", { name: "← 返回技能详情", exact: true })
        .click();
      await page.getByRole("button", { name: /版本历史/ }).click();
      await page.getByText("比较两个版本", { exact: true }).click();
      await page.getByLabel("基础版本").selectOption({ label: "v1" });
      await page.getByLabel("目标版本").selectOption({ label: "v2" });
      await page.getByRole("button", { name: "比较版本", exact: true }).click();
      await expect(page.getByLabel("版本差异")).toContainText("# 第一版");
      await expect(page.getByLabel("版本差异")).toContainText("# 第二版");
      await page
        .getByRole("button", { name: "恢复为草稿", exact: true })
        .nth(1)
        .click();
      await expect(
        page.getByRole("textbox", { name: "SKILL.md", exact: true }),
      ).toHaveValue("# 第一版\n\n真实浏览器内容。");
      await page
        .getByRole("button", { name: "← 返回技能详情", exact: true })
        .click();
      page.once("dialog", (d) => void d.accept());
      await page.getByRole("button", { name: "归档技能", exact: true }).click();
      await expect(
        page.getByText("技能已归档；历史保留，恢复后可继续编辑。"),
      ).toBeVisible();
      page.once("dialog", (d) => void d.accept());
      await page.getByRole("button", { name: "恢复归档技能" }).click();
      await expect(
        page.getByRole("button", { name: "编辑技能", exact: true }),
      ).toBeEnabled();
      await page.getByRole("button", { name: "← 全部技能" }).click();
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(
        page.getByRole("button", { name: /名称已更新/ }),
      ).toBeVisible();
      await mkdir("src/modules/product/test-results", { recursive: true });
      await page.screenshot({
        path: "src/modules/product/test-results/mobile.png",
        fullPage: true,
      });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        true,
        "窄屏不应横向溢出",
      );
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.screenshot({
        path: "src/modules/product/test-results/desktop.png",
        fullPage: true,
      });
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
