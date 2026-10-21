// End-to-end test in a real (headless) browser: every main feature, start to finish.
//
//   npm install && npx playwright install chromium   (once)
//   npm run test:e2e
//
// It starts the local server, signs up, loads the sample files (PDF, PowerPoint, Word, Markdown and a
// scanned PDF read with OCR), makes a quiz, answers it, checks the results, makes a practice quiz, edits
// a question, opens the worksheet, shares the quiz with a "classmate" in a separate browser, sends the
// classmate's result back, and checks that no page scrolls sideways on a phone.
// Set SCREENSHOTS=folder to save screenshots, CHROMIUM_PATH to use a specific Chromium.

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startMockModel } from "./mock-llm.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const port = 8000 + Math.floor(Math.random() * 900);
const base = `http://localhost:${port}/`;
const shots = process.env.SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });

const mockPort = port + 1000;
const model = startMockModel(mockPort);
const server = spawn(process.execPath, ["scripts/serve.js", String(port)], { cwd: root, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 600));

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const problems = [];
function watch(page, who) {
  page.on("pageerror", (e) => problems.push(`${who}: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource|transformers|jsdelivr|huggingface/i.test(m.text())) {
      problems.push(`${who} console: ${m.text()}`);
    }
  });
  page.on("dialog", (d) => {
    problems.push(`${who}: unexpected browser dialog "${d.message()}"`);
    d.dismiss();
  });
}
const shot = async (page, name) => shots && page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
const step = (name) => console.log(`- ${name}`);

let failed = false;
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  watch(page, "owner");
  page.setDefaultTimeout(30000);

  step("home page");
  await page.goto(base);
  await page.getByRole("heading", { name: "Turn your own lecture slides into a quiz." }).waitFor();
  await shot(page, "01-home");

  step("create an account");
  await page.getByRole("link", { name: "Create an account" }).first().click();
  await page.getByLabel("Name").fill("Swayam Shakya");
  await page.getByLabel("Email").fill("swayam.shakya@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByRole("heading", { name: "Your library" }).waitFor();

  step("load the sample files and read them (OCR included)");
  await page.getByRole("button", { name: "Load sample material" }).click();
  await page.locator("li", { hasText: "scanned-memory-management.pdf" }).waitFor();
  await page.waitForFunction(() => !document.body.innerText.includes("Reading file"), null, { timeout: 240000 });
  const libraryText = await page.locator("main").innerText();
  assert.ok(!libraryText.includes("Failed"), `a sample failed to load:\n${libraryText}`);
  for (const f of ["operating-systems-notes.pdf", "biology-energy-in-cells.pptx", "industrial-revolution.docx", "networking-basics.md"]) {
    assert.ok(libraryText.includes(f), `${f} missing`);
  }
  assert.match(libraryText, /read with OCR/, "the scanned PDF should be read with OCR");
  await shot(page, "02-library");

  step("topics of the slide deck");
  await page.getByRole("link", { name: "biology-energy-in-cells.pptx" }).click();
  await page.getByRole("heading", { name: "Topics found in this file" }).waitFor();
  const topics = await page.locator("ol.sheet > li").count();
  assert.ok(topics >= 2, `expected several topics, got ${topics}`);
  await page.getByRole("button", { name: /Show extracted text/ }).click();
  await page.getByText("Slide 1", { exact: false }).first().waitFor();
  await shot(page, "03-document");

  step("make a quiz from two files");
  await page.goto(`${base}#/quizzes/new`);
  await page.getByLabel("operating-systems-notes.pdf").check();
  await page.getByLabel("biology-energy-in-cells.pptx").check();
  await page.getByLabel("Number of questions").fill("12");
  await page.getByRole("button", { name: "Generate 12 questions" }).click();
  await page.getByRole("button", { name: "Start quiz" }).waitFor({ timeout: 60000 });
  const facts = await page.locator("dl").innerText();
  assert.match(facts, /Questions\s+12/);
  await shot(page, "04-quiz");

  step("review the answer key and open a source");
  await page.getByRole("button", { name: "Review questions and answers" }).click();
  await page.locator("ol.sheet li").first().getByRole("button", { name: / of / }).click();
  await page.getByRole("dialog").getByText("with the passage the question uses").waitFor();
  await page.locator("mark.marker").first().waitFor();
  await shot(page, "05-source");
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();

  step("edit a question");
  await page.locator("ol.sheet li").first().getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Question", { exact: true }).fill("Edited: which statement is right?");
  await page.getByRole("button", { name: "Save question" }).click();
  await page.getByText("Edited: which statement is right?").waitFor();

  step("take the quiz, answering every other question wrong");
  await page.getByRole("button", { name: "Start quiz" }).click();
  for (let i = 0; i < 12; i++) {
    const sheet = page.locator("article");
    await sheet.waitFor();
    const isShort = await sheet.locator("textarea").count();
    if (isShort) {
      await sheet.locator("textarea").fill(i % 2 ? "no idea" : "process");
      await sheet.getByRole("button", { name: "Check answer" }).click();
    } else {
      const options = sheet.getByRole("radio");
      await options.nth(i % 2 ? 1 : 0).click();
      await sheet.getByRole("button", { name: "Check answer" }).click();
    }
    await sheet.getByText(/^(Correct\.|Not quite\.|Partly right\.)$/).waitFor();
    if (i === 0) await shot(page, "06-feedback");
    const next = sheet.getByRole("button", { name: /Next question|See results/ });
    await next.click();
  }
  await page.getByRole("heading", { name: /of 12 correct/ }).waitFor();
  await page.getByRole("heading", { name: "Score by topic" }).waitFor();
  await shot(page, "07-results");

  step("retake only the missed questions");
  const retakeMissed = page.getByRole("button", { name: /Retake the \d+ you missed/ });
  if (await retakeMissed.count()) {
    await retakeMissed.click();
    await page.locator("article").waitFor();
    await page.getByRole("link", { name: "Leave quiz" }).click();
    await page.getByRole("heading", { name: /Quiz/ }).first().waitFor();
    await page.goBack();
    await page.goBack();
  }

  step("practice quiz on weak topics");
  await page.goto(`${base}#/library`);
  await page.getByRole("heading", { name: "Revise next" }).waitFor();
  const practise = page.getByRole("button", { name: "Practise this topic" }).first();
  if (await practise.count()) {
    await practise.click();
    await page.getByRole("button", { name: "Start quiz" }).waitFor({ timeout: 60000 });
    assert.match(await page.locator("h1").innerText(), /^Practice: /);
  } else {
    console.log("  (no weak topics this time)");
  }

  step("printable worksheet");
  await page.goto(`${base}#/library`);
  await page.getByRole("link", { name: /Operating Systems Notes \+ 1 More Quiz/ }).first().click();
  await page.getByRole("link", { name: "Print worksheet" }).click();
  await page.getByRole("heading", { name: "Answer key" }).waitFor();
  await shot(page, "08-worksheet");
  await page.getByRole("link", { name: "Back to quiz" }).click();

  step("share with a classmate");
  await page.getByRole("button", { name: "Create share link" }).click();
  const shareField = page.getByLabel("Share link");
  await page.waitForFunction(() => document.querySelector('input[aria-label="Share link"]')?.value.includes("#/s/"));
  const shareUrl = await shareField.inputValue();
  assert.ok(shareUrl.length < 30000, `share link is ${shareUrl.length} characters`);
  const quizUrl = page.url();

  const phone = await browser.newContext({ viewport: { width: 375, height: 760 }, isMobile: true, hasTouch: true });
  const guest = await phone.newPage();
  watch(guest, "classmate");
  guest.setDefaultTimeout(30000);
  await guest.goto(shareUrl);
  await guest.getByText("Swayam Shakya shared a quiz with you").waitFor();
  await guest.getByLabel("Your name").fill("Savyata Ghimire");
  await guest.getByRole("button", { name: "Start quiz" }).tap();
  for (let i = 0; i < 12; i++) {
    const sheet = guest.locator("article");
    await sheet.waitFor();
    if (await sheet.locator("textarea").count()) {
      await sheet.locator("textarea").fill("energy");
      await sheet.getByRole("button", { name: "Check answer" }).tap();
    } else {
      await sheet.getByRole("radio").first().tap();
      await sheet.getByRole("button", { name: "Check answer" }).tap();
    }
    await sheet.getByRole("button", { name: /Next question|See results/ }).tap();
  }
  await guest.getByRole("heading", { name: /of 12 correct/ }).waitFor();
  await guest.getByRole("heading", { name: /Send your result to Swayam Shakya/ }).waitFor();
  await guest.waitForFunction(() => document.querySelector('input[aria-label="Result link"]')?.value.includes("#/r/"));
  const resultUrl = await guest.getByLabel("Result link").inputValue();
  await shot(guest, "09-classmate-results");

  step("no sideways scrolling on a phone");
  for (const path of ["", "#/shared/x", "#/login"]) {
    await guest.goto(base + path);
    await guest.waitForTimeout(300);
    const wide = await guest.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(wide <= 1, `${path || "home"} is ${wide}px too wide on a phone`);
  }

  step("the classmate's result arrives on the owner's device");
  await page.goto(resultUrl);
  await page.getByRole("heading", { name: "Added Savyata Ghimire's result" }).waitFor();
  await page.goto(quizUrl);
  await page.getByRole("heading", { name: "Classmates", exact: true }).waitFor();
  await page.getByRole("link", { name: "Savyata Ghimire" }).waitFor();
  await shot(page, "10-classmates");

  step("data survives a reload");
  await page.reload();
  await page.getByRole("link", { name: "Savyata Ghimire" }).waitFor();

  step("connect an AI model (a local fake of the Anthropic API) and let it write a quiz");
  await page.goto(`${base}#/settings`);
  await page.getByText("Anthropic Claude").click();
  await page.getByRole("textbox", { name: "API key" }).fill("sk-ant-test-key");
  await page.getByLabel(/Server address/).fill(`http://localhost:${mockPort}`);
  await page.getByRole("button", { name: "Test connection" }).click();
  await page.getByText("Connected to anthropic:claude-sonnet-5-5").waitFor();
  await shot(page, "11-settings");
  await page.goto(`${base}#/quizzes/new`);
  await page.getByLabel("networking-basics.md").check();
  await page.getByLabel("Number of questions").fill("5");
  await page.getByRole("button", { name: "Generate 5 questions" }).click();
  await page.getByRole("button", { name: "Start quiz" }).waitFor({ timeout: 60000 });
  await page.getByText("Written by claude-sonnet-5-5").waitFor();
  const asked = model.requests.find((r) => r.name === "QuestionBatch");
  assert.ok(asked, "the model was asked for questions");
  assert.equal(asked.body.output_config.format.type, "json_schema");
  await page.getByRole("button", { name: "Review questions and answers" }).click();
  assert.ok(!(await page.locator("main").innerText()).includes("green cheese"), "made-up questions are dropped");

  step("back to the built-in generator");
  await page.goto(`${base}#/settings`);
  await page.getByText("Built-in generator").click();
  await page.getByRole("button", { name: "Save settings" }).click();
  await page.getByText("Saved.").waitFor();

  step("signed-in pages fit a phone screen");
  await page.setViewportSize({ width: 375, height: 760 });
  const quizPath = new URL(quizUrl).hash;
  for (const path of ["#/library", "#/quizzes/new", quizPath, `${quizPath}/print`, "#/settings", "#/documents/2"]) {
    await page.goto(base + path);
    await page.waitForTimeout(400);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(wide <= 1, `${path} is ${wide}px too wide on a phone`);
  }
  await shot(page, "12-phone-document");

  assert.deepEqual(problems, [], `errors in the page:\n${problems.join("\n")}`);
  console.log("\nAll end-to-end checks passed.");
} catch (err) {
  failed = true;
  console.error("\nEnd-to-end test failed:", err.message);
  if (problems.length) console.error(problems.join("\n"));
} finally {
  await browser.close();
  server.kill();
  model.close();
}
process.exit(failed ? 1 : 0);
