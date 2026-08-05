const $ = (id) => document.getElementById(id);

chrome.storage.sync
  .get({ bridgeUrl: "http://127.0.0.1:17891", token: "" })
  .then(({ bridgeUrl, token }) => {
    $("bridgeUrl").value = bridgeUrl;
    $("token").value = token;
  });

$("save").addEventListener("click", async () => {
  await chrome.storage.sync.set({
    bridgeUrl: $("bridgeUrl").value.trim(),
    token: $("token").value.trim(),
  });
  $("saved").textContent = "保存しました";
  setTimeout(() => ($("saved").textContent = ""), 1500);
});
