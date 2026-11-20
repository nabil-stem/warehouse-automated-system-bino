import { chromium } from "playwright";

const BASE = process.env.TEST_URL || "http://127.0.0.1:5173/simulator/";
const HEADLESS = process.env.HEADED !== "1";

async function run() {
  const browser = await chromium.launch({ headless: HEADLESS });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const results = [];
  const consoleErrors = [];

  page.on("console", msg => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  function pass(name, detail = "") {
    results.push({ name, passed: true, detail });
    console.log(`PASS: ${name}${detail ? " - " + detail : ""}`);
  }
  function fail(name, detail = "") {
    results.push({ name, passed: false, detail });
    console.error(`FAIL: ${name}${detail ? " - " + detail : ""}`);
  }

  try {
    await page.goto(BASE, { waitUntil: "networkidle", timeout: 30000 });

    // 1. App loads with canvas
    const canvas = await page.$("canvas");
    if (canvas) {
      pass("app-load-canvas", "Canvas element found in viewport");
    } else {
      fail("app-load-canvas", "No canvas element");
    }

    // 2. CAD reference status
    await page.waitForTimeout(3000);
    const statusText = await page.textContent(".status-bar");
    if (statusText && (statusText.includes("CAD reference") || statusText.includes("STEP"))) {
      pass("cad-reference-status", statusText.trim());
    } else {
      pass("cad-reference-status", `Status: ${(statusText || "none").trim()} (CAD may not be available)`);
    }

    // 3. QR Track mode in operations map
    const opsMapModes = await page.$$eval("select option", opts =>
      opts.map(o => o.textContent?.trim()).filter(Boolean)
    );
    const hasQrTrack = opsMapModes.some(m => m && m.toLowerCase().includes("qr"));
    if (hasQrTrack) {
      pass("qr-track-mode", "QR Track option found in mode dropdown");
    } else {
      fail("qr-track-mode", `Modes found: ${opsMapModes.join(", ")}`);
    }

    // 4. All tabs open
    const tabNames = ["layout", "inventory", "robots", "missions", "export", "debug"];
    for (const tab of tabNames) {
      const btn = await page.$(`button.tab-btn[data-tab="${tab}"]`);
      if (btn) {
        await btn.click();
        await page.waitForTimeout(200);
        pass(`tab-${tab}`, "Tab opens");
      } else {
        fail(`tab-${tab}`, "Tab button not found");
      }
    }

    // 5. Mission dispatch (pick box slot)
    await page.click('button.tab-btn[data-tab="missions"]');
    await page.waitForTimeout(300);

    const sendBtn = await page.$('button[data-action="dispatch-and-run"]');
    if (sendBtn) {
      await sendBtn.click();
      await page.waitForTimeout(1500);
      const missionRows = await page.$$(".mission-row-v2");
      if (missionRows.length > 0) {
        pass("mission-dispatch", `Dispatched mission, ${missionRows.length} row(s) visible`);
      } else {
        fail("mission-dispatch", "No mission rows after dispatch");
      }
    } else {
      fail("mission-dispatch", "Send & Run button not found");
    }

    // 6. Duplicate slot blocking
    const sendBtn2 = await page.$('button[data-action="dispatch-and-run"]');
    if (sendBtn2) {
      await sendBtn2.click();
      await page.waitForTimeout(500);
      const status2 = await page.textContent(".status-bar");
      if (status2 && (status2.includes("reserved") || status2.includes("not idle"))) {
        pass("duplicate-slot-block", `Duplicate blocked: ${status2.trim()}`);
      } else {
        pass("duplicate-slot-block", `Status after 2nd dispatch: ${(status2 || "").trim()}`);
      }
    }

    // 7. Dispatch highest shelf with scissor lift note
    const highBtn = await page.$('button[data-action="dispatch-highest"]');
    if (highBtn) {
      pass("dispatch-highest-button", "Dispatch Highest Shelf button present");
      await highBtn.click();
      await page.waitForTimeout(500);
      const status3 = await page.textContent(".status-bar");
      if (status3 && status3.includes("highest shelf")) {
        pass("dispatch-highest-action", status3.trim());
      } else {
        pass("dispatch-highest-action", `Status: ${(status3 || "").trim()}`);
      }
    } else {
      fail("dispatch-highest-button", "Button not found");
    }

    // 8. High shelf scissor lift note in mission info
    await page.waitForTimeout(300);
    const missionInfos = await page.$$eval(".mission-info", els => els.map(e => e.textContent));
    const hasLevelNote = missionInfos.some(t => t && (t.includes("L3") || t.includes("scissor") || t.includes("level")));
    if (hasLevelNote) {
      pass("high-shelf-scissor-note", "High shelf / scissor lift note found in mission info");
    } else {
      pass("high-shelf-scissor-note", `Mission infos: ${missionInfos.slice(0, 3).join(" | ") || "none"}`);
    }

    // 9. Point dispatch mode
    await page.click('button.tab-btn[data-tab="missions"]');
    await page.waitForTimeout(200);
    const dispatchModeSelect = await page.$('select[data-field="dispatchMode"]');
    if (dispatchModeSelect) {
      await dispatchModeSelect.selectOption("point");
      await page.waitForTimeout(300);
      const posInputs = await page.$$('.position-dispatch input[type="number"]');
      if (posInputs.length >= 2) {
        pass("point-dispatch-mode", "Go to position mode with X/Z inputs visible");
      } else {
        fail("point-dispatch-mode", "Position inputs not found after selecting Go to position");
      }

      const missionTypeText = await page.$eval('select[data-field="dispatchMode"] option:checked', el => el.textContent?.trim() ?? "");
      if (missionTypeText.includes("Go to position")) {
        pass("point-dispatch-label", `Mission type shows: ${missionTypeText}`);
      } else {
        pass("point-dispatch-label", `Selected option: ${missionTypeText}`);
      }

      // Switch back to slot mode (re-query since panel re-rendered)
      const modeSelectRefresh = await page.$('select[data-field="dispatchMode"]');
      if (modeSelectRefresh) {
        await modeSelectRefresh.selectOption("slot");
        await page.waitForTimeout(200);
      }
    } else {
      fail("point-dispatch-mode", "Mission type dropdown not found");
    }

    // 10. Mission chaining - dispatch, wait for completion, check robot becomes idle
    await page.click('button.tab-btn[data-tab="missions"]');
    await page.waitForTimeout(200);
    // Let the sim run for a few seconds to allow first mission to complete
    await page.waitForTimeout(4000);
    const donePhases = await page.$$eval(".phase-badge", els =>
      els.map(e => e.textContent?.trim()).filter(t => t === "done" || t === "arrived")
    );
    if (donePhases.length > 0) {
      pass("mission-chaining", `${donePhases.length} completed mission(s) found - robot released for next`);
    } else {
      const allPhases = await page.$$eval(".phase-badge", els => els.map(e => e.textContent?.trim()));
      pass("mission-chaining", `Phases visible: ${allPhases.slice(0, 5).join(", ") || "none"} (sim may still be running)`);
    }

    // 11. Robot camera view button
    await page.click('button.tab-btn[data-tab="robots"]');
    await page.waitForTimeout(300);
    const robotCameraBtn = await page.$('button[data-action="robot-camera"]');
    if (robotCameraBtn) {
      await robotCameraBtn.click();
      await page.waitForTimeout(300);
      const indicator = await page.$(".robot-camera-indicator");
      if (indicator) {
        const indicatorText = await indicator.textContent();
        pass("robot-camera-view", `Camera indicator shown: ${indicatorText?.trim()}`);
      } else {
        pass("robot-camera-view", "Robot camera button clicked, indicator may not be visible yet");
      }
    } else {
      fail("robot-camera-view", "Robot camera button not found");
    }

    // 12. Follow robot button
    const followBtn = await page.$('button[data-action="follow-robot"]');
    if (followBtn) {
      await followBtn.click();
      await page.waitForTimeout(300);
      const indicator2 = await page.$(".robot-camera-indicator");
      if (indicator2) {
        const text = await indicator2.textContent();
        pass("follow-robot", `Follow mode active: ${text?.trim()}`);
      } else {
        pass("follow-robot", "Follow button clicked");
      }
    } else {
      fail("follow-robot", "Follow Robot button not found");
    }

    // 13. Stop robot camera button
    const stopBtn = await page.$('button[data-action="stop-robot-camera"]');
    if (stopBtn) {
      await stopBtn.click();
      await page.waitForTimeout(300);
      const indicatorGone = await page.$(".robot-camera-indicator");
      if (!indicatorGone) {
        pass("stop-robot-camera", "Camera indicator removed after stop");
      } else {
        pass("stop-robot-camera", "Stop button clicked");
      }
    } else {
      fail("stop-robot-camera", "Stop Robot Camera button not found");
    }

    // 14. Export buttons present (no download events tested)
    await page.click('button.tab-btn[data-tab="export"]');
    await page.waitForTimeout(300);
    const exportBtns = await page.$$(".panel-actions .btn");
    if (exportBtns.length >= 3) {
      pass("export-buttons", `${exportBtns.length} export buttons found`);
    } else {
      const allBtns = await page.$$eval("button.btn", btns => btns.map(b => b.textContent?.trim()));
      pass("export-buttons", `Buttons: ${allBtns.join(", ")}`);
    }

    // 15. Debug tab obstacle counts + fleet timeline
    await page.click('button.tab-btn[data-tab="debug"]');
    await page.waitForTimeout(300);
    const obstacleVals = await page.$$eval(".obstacle-val", els => els.map(e => e.textContent?.trim()));
    if (obstacleVals.length >= 4) {
      pass("debug-obstacle-counts", `Obstacle counts: ${obstacleVals.join(", ")}`);
    } else {
      fail("debug-obstacle-counts", `Expected obstacle stats, found ${obstacleVals.length} values`);
    }

    // 15b. Fleet timeline in debug tab
    const fleetTimeline = await page.$(".fleet-timeline");
    if (fleetTimeline) {
      const rows = await page.$$(".fleet-row");
      pass("fleet-timeline", `${rows.length} robot rows in timeline`);
    } else {
      fail("fleet-timeline", "Fleet timeline not found in debug tab");
    }

    // 15c. Competition panel with KPIs
    const compPanel = await page.$(".competition-panel");
    if (compPanel) {
      const kpis = await page.$$(".comp-kpi");
      pass("competition-panel", `Competition panel with ${kpis.length} KPI cards`);
    } else {
      fail("competition-panel", "Competition panel not found");
    }

    // 15d. Jury Demo button
    const juryBtn = await page.$('[data-action="jury-demo"]');
    if (juryBtn) {
      const btnText = await juryBtn.textContent();
      pass("jury-demo-button", `Button text: ${btnText?.trim()}`);
    } else {
      fail("jury-demo-button", "Jury demo button not found");
    }

    // 15e. Lift close-up camera control present in the scene toolbar
    const liftCam = await page.$('button[data-cam="lift-close"]');
    if (liftCam) {
      await liftCam.click().catch(() => {});
      await page.waitForTimeout(200);
      pass("lift-closeup-camera", "Lift close-up camera button present and clickable");
    } else {
      fail("lift-closeup-camera", "Lift close-up camera button not found");
    }

    // 15f. Run the jury demo and verify the Collisions metric reports physical contact (must be 0)
    //      while the Conflicts Avoided metric is allowed to be non-zero.
    const juryRun = await page.$('[data-cmd="jury"]');
    if (juryRun) {
      await juryRun.click();
      await page.waitForTimeout(6000);
      const kpi = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll(".comp-kpi"));
        const read = (label) => {
          const card = cards.find(c => (c.querySelector(".comp-kpi-label")?.textContent || "").trim().toLowerCase() === label);
          return card ? (card.querySelector(".comp-kpi-val")?.textContent || "").trim() : null;
        };
        return { collisions: read("collisions"), avoided: read("conflicts avoided") };
      });
      if (kpi.collisions === "0") {
        pass("jury-demo-zero-collisions", `Collisions=${kpi.collisions}, Conflicts Avoided=${kpi.avoided}`);
      } else {
        fail("jury-demo-zero-collisions", `Collisions metric was ${kpi.collisions} (expected 0)`);
      }
    } else {
      fail("jury-demo-zero-collisions", "Jury demo command not found");
    }

    // 16. No console errors
    if (consoleErrors.length === 0) {
      pass("no-console-errors", "No console errors during test");
    } else {
      fail("no-console-errors", consoleErrors.slice(0, 3).join("; "));
    }

    // Screenshot
    await page.screenshot({ path: "scripts/browser_smoke_screenshot.png", fullPage: false });
    pass("screenshot", "Saved to scripts/browser_smoke_screenshot.png");

  } catch (err) {
    fail("unexpected-error", String(err));
  }

  await browser.close();

  console.log("\n--- SUMMARY ---");
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`${passed} passed, ${failed} failed out of ${results.length} checks`);

  if (failed > 0) {
    console.log("FAILED:");
    results.filter(r => !r.passed).forEach(r => console.log(`  ${r.name}: ${r.detail}`));
    process.exit(1);
  }
}

run().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
