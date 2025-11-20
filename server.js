// --- caption.html: inside tryBoost function ---
async function tryBoost() {
  if (hasBoostedCurrentOutput) return;
  if (!lastResultText || !lastIdea || !lastPlatform || !lastTone) return;

  if (!isPro && freeUses >= MAX_FREE_USES) {
    if (paywallEl) paywallEl.classList.remove("hidden");
    return;
  }

  boostBtn.disabled = true;
  boostBtn.textContent = "Boosting...";

  try {
    const res = await fetch(`${API_URL}/optimize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        idea: lastIdea,
        platform: lastPlatform,
        tone: lastTone,
        email: userEmail,
        captions: lastResultText,
        previousScore: lastScore,
        currentGenerations: freeUses // ⬅️ CRITICAL: Send current usage count
      })
    });

    const data = await res.json();

    if (res.status === 402) {
      showToast("Free generations exhausted. Please upgrade!", 'error');
      if (paywallEl) paywallEl.classList.remove("hidden");
      return;
    }
    
    // Server-side error (500)
    if (!res.ok) {
        throw new Error(data.error || 'Server error');
    }

    if (res.ok && data.result) {
      showToast("Boost successful! New result generated.", 'success');
      lastResultText = data.result;
      if (outputEl) outputEl.textContent = data.result;
      
      const newScore = computeEngagementScore(data.result, lastIdea, lastPlatform, lastTone);
      lastScore = newScore;
      updateEngagementUI(newScore, true);
      
      // Update count from server response
      if (!isPro && typeof data.newGenerationsCount === 'number') { 
        freeUses = data.newGenerationsCount; 
        localStorage.setItem('freeUses', String(freeUses)); 
        updateFreeUsageBar();
      }

    } else {
        showToast("Boost failed. Please try again.", 'error');
    }

  } catch (err) {
    console.error("Boost error:", err);
    showToast(`Error: ${err.message}`, 'error');
  } finally {
    hasBoostedCurrentOutput = true;
    boostBtn.disabled = true;
    boostBtn.classList.add("used");
    boostBtn.textContent = "Boost Applied";
    updateGenerateButtonState();
  }
}