/* Show the active translation while browsing results or reading a PDF. */
(() => {
  "use strict";
  const ACTIVE_KEY = "readpi-active-job";
  const terminal = new Set(["succeeded", "failed", "cancelled"]);
  let seenRunning = "";
  let notified = "";
  let timer = null;

  const card = document.createElement("aside");
  card.className = "job-monitor";
  card.hidden = true;
  card.setAttribute("aria-live", "polite");
  card.innerHTML = `<div class="job-monitor-copy"><strong>正在翻译</strong>
    <span class="job-monitor-name"></span><span class="job-monitor-stage"></span></div>
    <strong class="job-monitor-percent"></strong><div class="job-monitor-track"><i></i></div>
    <a class="job-monitor-link" href="/">查看翻译进度 →</a>`;
  document.body.appendChild(card);

  const notice = document.createElement("div");
  notice.className = "job-complete-overlay";
  notice.hidden = true;
  notice.innerHTML = `<section class="job-complete-dialog" role="dialog" aria-modal="true"
      aria-labelledby="job-complete-title"><div class="job-complete-icon" aria-hidden="true">✓</div>
    <h2 id="job-complete-title">翻译完成</h2><p>译文已保存，可以在结果库中阅读。</p>
    <div class="job-complete-actions"><button type="button" data-close>稍后查看</button>
    <a href="/library" data-library>打开结果库</a></div></section>`;
  document.body.appendChild(notice);
  const dismiss = () => { notice.hidden = true; };
  notice.querySelector("[data-close]").addEventListener("click", dismiss);
  notice.addEventListener("click", (event) => {
    if (event.target === notice) dismiss();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !notice.hidden) dismiss();
  });

  function showDone(job) {
    notified = job.id;
    sessionStorage.setItem(`readpi-notified-${job.id}`, "1");
    notice.hidden = false;
    notice.querySelector("[data-library]").href = "/library";
    document.dispatchEvent(new CustomEvent("studio:job-complete", { detail: job }));
  }

  async function update() {
    try {
      const data = await window.Studio.api("/api/jobs/current");
      const job = data && data.job;
      if (!job) { card.hidden = true; return; }
      if (!terminal.has(job.status)) {
        seenRunning = job.id;
        localStorage.setItem(ACTIVE_KEY, job.id);
        const value = Math.max(0, Math.min(100, Number(job.progress) || 0));
        card.hidden = false;
        card.querySelector(".job-monitor-name").textContent = (job.files || []).join("、") || "PDF";
        card.querySelector(".job-monitor-stage").textContent = job.stage || "运行中";
        card.querySelector(".job-monitor-percent").textContent = `${Math.round(value)}%`;
        card.querySelector(".job-monitor-track i").style.width = `${value}%`;
        card.querySelector(".job-monitor-link").href = `/?job=${encodeURIComponent(job.id)}`;
      } else {
        card.hidden = true;
        const recent = Number(job.finished_at) > Date.now() / 1000 - 30;
        const tracked = seenRunning === job.id ||
          (recent && localStorage.getItem(ACTIVE_KEY) === job.id);
        if (job.status === "succeeded" && tracked && notified !== job.id &&
            !sessionStorage.getItem(`readpi-notified-${job.id}`)) showDone(job);
      }
    } catch (error) {
      card.hidden = true;
      console.warn("[ReadPI] 无法读取翻译进度", error);
    } finally {
      timer = window.setTimeout(update, document.hidden ? 5000 : 1400);
    }
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { clearTimeout(timer); update(); }
  });
  update();
})();
