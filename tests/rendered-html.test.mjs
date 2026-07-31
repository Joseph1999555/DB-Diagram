import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const templateRoot = new URL("../", import.meta.url);

test("build emits the Relix workspace", async () => {
  const [workspace, layout] = await Promise.all([
    readFile(new URL("../components/diagram-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  ]);

  await access(new URL("../dist/server/index.js", import.meta.url));
  assert.match(workspace, /Northstar Commerce/);
  assert.match(workspace, /Schema source/);
  assert.match(workspace, /Valid DBML/);
  assert.match(layout, /Relix/);
  assert.match(layout, /og\.png/);
  assert.doesNotMatch(workspace, /Your site is taking shape/);
});

test("removes starter-preview infrastructure and ships product metadata", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /DiagramWorkspace/);
  assert.match(layout, /Relix/);
  assert.match(layout, /og\.png/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await access(new URL("../public/og.png", import.meta.url));
  await assert.rejects(access(new URL("../app\/_sites-preview/SkeletonPreview.tsx", templateRoot)));
});

test("ships persistent themes and the diagram performance contracts", async () => {
  const [layout, theme, switcher, styles, workspace] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/theme.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/theme-switcher.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../components/diagram-workspace.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(theme, /THEME_STORAGE_KEY\s*=\s*["']relix:theme["']/);
  assert.match(layout, /localStorage\.getItem/);
  assert.match(layout, /matchMedia\(["']\(prefers-color-scheme: dark\)["']\)/);
  assert.match(layout, /\.dataset\.theme\s*=/);
  assert.match(layout, /dangerouslySetInnerHTML=\{\{ __html: THEME_BOOTSTRAP \}\}/);

  assert.match(switcher, /aria-label="Color theme"/);
  assert.match(switcher, /aria-pressed=\{selected\}/);
  for (const label of ["System", "Light", "Dark"]) {
    assert.match(switcher, new RegExp(`label: ["']${label}["']`));
  }

  assert.match(styles, /:root\[data-theme="dark"\][\s\S]*?color-scheme:\s*dark/);
  assert.match(styles, /:root\[data-theme="light"\][\s\S]*?color-scheme:\s*light/);

  assert.match(workspace, /import\("html-to-image"\)/);
  assert.doesNotMatch(workspace, /from ["']html-to-image["']/);
  assert.match(workspace, /await import\("@\/lib\/schema-export"\)/);
  assert.match(workspace, /memo\(function TableNodeCard/);
  assert.match(workspace, /memo\(function GroupFrameNode/);
  assert.match(workspace, /onlyRenderVisibleElements/);
  assert.match(workspace, /onNodesChange=\{handleNodesChange\}/);
  assert.match(workspace, /change\.dragging !== true/);
  assert.match(workspace, /requestIdleCallback/);
  assert.match(workspace, /Promise\.allSettled/);

  const flowStart = workspace.indexOf("<ReactFlow");
  const flowEnd = workspace.indexOf("<Background", flowStart);
  assert.ok(flowStart >= 0 && flowEnd > flowStart, "ReactFlow props must be present");
  assert.doesNotMatch(workspace.slice(flowStart, flowEnd), /\bonMove\s*=/);

  assert.match(
    workspace,
    /<pre className="line-number-list" ref=\{lineNumbersRef\}>\{editorLineNumbers\}<\/pre>/,
  );
  assert.doesNotMatch(workspace, /<div className="line-number-list"/);
});
