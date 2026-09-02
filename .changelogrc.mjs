import conventionalCommits from "conventional-changelog-conventionalcommits";

const preset = await conventionalCommits();

const ignoredCommitHeaders =
  "^(?:chore\\(release\\): generate conventional changelog|docs\\(api\\): document API changelog)";

export default {
  ...preset,
  gitRawCommitsOpts: {
    ignore: ignoredCommitHeaders,
  },
  options: {
    outputUnreleased: true,
    releaseCount: 0,
    context: {
      linkCompare: false,
      version: "Unreleased",
    },
  },
  writerOpts: {
    ...preset.writer,
    // Keep the generated file stable when the repository has no release tags.
    headerPartial: "## Unreleased\n",
  },
};
