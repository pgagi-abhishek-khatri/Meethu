const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// A build with no OpenWhispr API has no workspace server: signed-in users there are unmanaged, so
// meeting recording on their own keys (Soniox) is not refused as "restricted by your organization".
async function loadPolicyStore(t, getWorkspacePolicy) {
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getWorkspacePolicy,
        getAppVersion: async () => "1.10.4",
        onWorkspacePolicyChanged: () => () => {},
      },
      addEventListener: () => {},
      setInterval: () => 0,
    },
  });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-policy-store-" });
  return vite.ssrLoadModule("/stores/policyStore.ts");
}

test("no OpenWhispr API configured resolves the policy as unmanaged, not error", async (t) => {
  const { usePolicyStore } = await loadPolicyStore(t, async () => ({
    success: false,
    status: "error",
    code: "POLICY_UNAVAILABLE",
    error: "OpenWhispr API URL not configured",
  }));
  await usePolicyStore.getState().fetchPolicy("acct-1", 1);
  assert.equal(usePolicyStore.getState().status, "unmanaged");
  assert.equal(usePolicyStore.getState().managed, false);
});

test("any other policy failure still fails closed", async (t) => {
  const { usePolicyStore } = await loadPolicyStore(t, async () => ({
    success: false,
    status: "error",
    code: "POLICY_UNAVAILABLE",
    error: "network down",
  }));
  await usePolicyStore.getState().fetchPolicy("acct-1", 1);
  assert.equal(usePolicyStore.getState().status, "error");
});
