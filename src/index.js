const { join } = require("path");

const git = require("./git");
const { createCheck } = require("./github/api");
const { getContext } = require("./github/context");
const linters = require("./linters");
const { getInput, log } = require("./utils/action");
const { getSummary } = require("./utils/lint-result");

const GIT_EMAIL = "dev@volla.live";
const GIT_NAME = "Lint";

// Abort action on unhandled promise rejections
process.on("unhandledRejection", err => {
	log(err, "error");
	throw new Error(`Exiting because of unhandled promise rejection`);
});

/**
 * Parses the action configuration and runs all enabled linters on matching files
 */
async function runAction() {
	const context = getContext();
	const autoFix = getInput("auto_fix") === "true";
	const commitMsg = getInput("commit_message", true);

	// If on a PR from fork: Display messages regarding action limitations
	if (context.eventName === "pull_request" && context.repository.hasFork) {
		log(
			"This action does not have permission to create annotations on forks. You may want to run it only on `push` events. See https://github.com/samuelmeuli/lint-action/issues/13 for details",
			"error",
		);
		if (autoFix) {
			log(
				"This action does not have permission to push to forks. You may want to run it only on `push` events. See https://github.com/samuelmeuli/lint-action/issues/13 for details",
				"error",
			);
		}
	}

	if (autoFix) {
		// Set Git committer username and password
		git.setUserInfo(GIT_NAME, GIT_EMAIL);
	}
	if (context.eventName === "pull_request") {
		// Fetch and check out PR branch:
		// - "push" event: Already on correct branch
		// - "pull_request" event on origin, for code on origin: The Checkout Action
		//   (https://github.com/actions/checkout) checks out the PR's test merge commit instead of the
		//   PR branch. Git is therefore in detached head state. To be able to push changes, the branch
		//   needs to be fetched and checked out first
		// - "pull_request" event on origin, for code on fork: Same as above, but the repo/branch where
		//   changes need to be pushed is not yet available. The fork needs to be added as a Git remote
		//   first
		git.checkOutRemoteBranch(context);
	}

	const checks = [];

	// Loop over all available linters
	for (const [linterId, linter] of Object.entries(linters)) {
		// Determine whether the linter should be executed on the commit
		if (getInput(linterId) === "true") {
			const fileExtensions = getInput(`${linterId}_extensions`, true);
			const args = getInput(`${linterId}_args`) || "";
			const lintDirRel = getInput(`${linterId}_dir`) || ".";
			const lintDirAbs = join(context.workspace, lintDirRel);

			// Check that the linter and its dependencies are installed
			log(`\nVerifying setup for ${linter.name}…`);
			await linter.verifySetup(lintDirAbs);
			log(`Verified ${linter.name} setup`);

			// Determine which files should be linted
			const fileExtList = fileExtensions.split(",");
			log(`Will use ${linter.name} to check the files with extensions ${fileExtList}`);

			// Lint and optionally auto-fix the matching files, parse code style violations
			log(
				`Linting ${autoFix ? "and auto-fixing " : ""}files in ${lintDirAbs} with ${linter.name}…`,
			);
			const lintOutput = linter.lint(lintDirAbs, fileExtList, args, autoFix);

			// Parse output of linting command
			const lintResult = linter.parseOutput(context.workspace, lintOutput);
			const summary = getSummary(lintResult);
			log(`${linter.name} found ${summary} (${lintResult.isSuccess ? "success" : "failure"})`);

			if (autoFix) {
				// Commit and push auto-fix changes
				if (git.hasChanges()) {
					git.commitChanges(commitMsg.replace(/\${linter}/g, linter.name));
					git.pushChanges();
				}
			}

			checks.push({ checkName: linter.name, lintResult, summary });
		}
	}

	// Add commit annotations after running all linters. To be displayed on pull requests, the
	// annotations must be added to the last commit on the branch. This can either be a user commit or
	// one of the auto-fix commits
	log(""); // Create empty line in logs
	const headSha = git.getHeadSha();
	await Promise.all(
		checks.map(({ checkName, lintResult, summary }) =>
			createCheck(checkName, headSha, context, lintResult, summary),
		),
	);
}

runAction();
