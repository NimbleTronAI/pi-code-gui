# Sample Workspace

A scratch folder the **Run Extension** (F5) launch config opens in the Extension
Development Host, so it starts with a real workspace folder — and the Pi agent
gets a valid working directory — instead of opening empty (which made `cwd` fall
back to the VS Code server directory).

It deliberately lives in its own folder (not the repo root) because VS Code can't
open the same folder that's already open in your main window — it would just
focus that window instead of launching the dev host.

Add throwaway files here to exercise the agent. Safe to edit freely. To test the
agent against the extension's own source instead, launch the dev host and use
**File → Open Folder**.
