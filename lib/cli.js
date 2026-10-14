#!/usr/bin/env node
import { n as getRuntime, t as REGIONS } from "./tianshu-runtime-CcvE-nfe.js";
//#region src/tianshu-cli.ts
function print(value) {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
function parseRegion(value) {
	if (value === void 0) return void 0;
	if (REGIONS.includes(value)) return value;
	throw new Error("region 必须是 cn 或 global");
}
async function main() {
	const [command = "help", regionArg, model] = process.argv.slice(2);
	const runtime = await getRuntime();
	const region = parseRegion(regionArg);
	try {
		switch (command) {
			case "setup":
				print(await runtime.setup(region));
				return;
			case "status":
				print(await runtime.snapshot());
				return;
			case "refresh":
				print({
					refreshed: await runtime.refresh(region),
					registered: await runtime.setup(region)
				});
				return;
			case "test":
				print(await runtime.endpointTest(region));
				return;
			case "smoke":
				if (region === void 0 || !model) throw new Error("用法：tianshu-connect-workbuddy smoke <cn|global> <model-id>");
				print(await runtime.modelTest(region, model));
				return;
			case "login": {
				if (region === void 0) throw new Error("用法：tianshu-connect-workbuddy login <cn|global>");
				const started = await runtime.startLogin(region, true);
				print(started);
				const loginId = typeof started.loginId === "string" ? started.loginId : void 0;
				const expiresIn = typeof started.expiresIn === "number" ? started.expiresIn : 300;
				if (loginId === void 0) throw new Error("登录启动失败");
				const deadline = Date.now() + expiresIn * 1e3;
				while (Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 2e3));
					const answer = await runtime.finishLogin(region, loginId);
					if (answer.pending === true) continue;
					print(answer);
					return;
				}
				throw new Error("登录等待超时，请重新执行 login");
			}
			default: process.stdout.write([
				"Tianshu Connect WorkBuddy",
				"",
				"  setup [cn|global]          注册天枢 Provider",
				"  status                     查看账号、余额、模型和倍率",
				"  login <cn|global>          浏览器登录并自动同步",
				"  refresh [cn|global]        刷新目录并同步",
				"  test [cn|global]           测试本地端点（不调用模型）",
				"  smoke <region> <model-id>  真实模型调用（会消耗积分）",
				""
			].join("\n"));
		}
	} finally {
		await runtime.close();
	}
}
main().catch((error) => {
	process.stderr.write(`tianshu-connect-workbuddy: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
//#endregion
export {};
