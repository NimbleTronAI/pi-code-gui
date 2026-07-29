import * as assert from "node:assert";
import { PiPackageService } from "../pi-package-service.js";
import { PiService } from "../pi-service.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- focused white-box resource tests
type MutableService = Record<string, any>;

suite("Pi capabilities", () => {
  test("lists extension commands, prompt templates, and enabled skills", () => {
    const service = new PiService() as unknown as MutableService;
    service.session = {
      extensionRunner: {
        getRegisteredCommands: () => [{
          invocationName: "review",
          description: "Review changes",
          sourceInfo: { scope: "user" },
        }],
      },
    };
    service.resourceLoader = {
      getPrompts: () => ({
        prompts: [{
          name: "release",
          description: "Prepare a release",
          sourceInfo: { scope: "project" },
        }],
      }),
      getSkills: () => ({
        skills: [{
          name: "karpathy-guidelines",
          description: "Keep code changes surgical",
          filePath: "C:/Users/test/.agents/skills/karpathy-guidelines/SKILL.md",
          sourceInfo: { scope: "user" },
        }],
      }),
    };

    const commands = service.getAllSlashCommands();

    assert.ok(commands.some((command: { cmd: string; source: string }) =>
      command.cmd === "/review" && command.source === "extension"));
    assert.ok(commands.some((command: { cmd: string; source: string }) =>
      command.cmd === "/release" && command.source === "prompt"));
    assert.ok(commands.some((command: { cmd: string; source: string }) =>
      command.cmd === "/skill:karpathy-guidelines" && command.source === "skill"));
  });

  test("persists a top-level skill disable filter", async () => {
    const service = new PiPackageService() as unknown as MutableService;
    let savedSkillPaths: string[] | undefined;
    service.settingsManager = {
      reload: async () => undefined,
      getGlobalSettings: () => ({ skills: [] }),
      getProjectSettings: () => ({}),
      setSkillPaths: (paths: string[]) => { savedSkillPaths = paths; },
    };
    service.packageManager = {
      resolve: async () => ({
        extensions: [],
        skills: [{
          path: "C:/Users/test/.agents/skills/review/SKILL.md",
          enabled: true,
          metadata: {
            source: "auto",
            scope: "user",
            origin: "top-level",
            baseDir: "C:/Users/test/.agents",
          },
        }],
      }),
    };

    await service.setCapabilityEnabled(
      "skill",
      "C:/Users/test/.agents/skills/review/SKILL.md",
      false,
    );

    assert.deepStrictEqual(savedSkillPaths, ["-skills/review/SKILL.md"]);
  });
});
