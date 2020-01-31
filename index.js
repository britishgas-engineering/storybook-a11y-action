const core = require('@actions/core');
const puppeteer = require('puppeteer-core');
const { Cluster } = require('puppeteer-cluster');
const axeCore = require('axe-core');
const colors = require('colors');
const path = require('path');
const os = require("os");

const opts = ['--no-sandbox', '--disable-setuid-sandbox'];
const localhost = `file://${process.env.GITHUB_WORKSPACE}${core.getInput('directory')}`;

if (!localhost) {
  core.warning('Directory was not set');
}

const getChromePath = () => {
  let browserPath;

  if (os.type() === "Windows_NT") {
    // Chrome is usually installed as a 32-bit application, on 64-bit systems it will have a different installation path.
    const programFiles = os.arch() === 'x64' ? process.env["PROGRAMFILES(X86)"] : process.env.PROGRAMFILES;
    browserPath = path.join(programFiles, "Google/Chrome/Application/chrome.exe");
  } else if (os.type() === "Linux") {
    browserPath = "/usr/bin/google-chrome";
  }

  if (browserPath && browserPath.length > 0) {
    return path.normalize(browserPath);
  }

  throw new TypeError(`Cannot run action. ${os.type} is not supported.`);
}

const unknownError = (e) => {
  console.log(e);
  const message = 'Something went wrong, please make sure storybook is running or is pointed to the right location.';
  console.error(message.red);
  core.setFailed(message);
  process.exit(1);
}

const logger = (story, violation) => {
  const name = `${story.kind}: ${story.name}`;

  if (violation) {
    const {description, helpUrl, nodes} = violation;

    console.error(
      `
      ${name}
      `.cyan,
      `  ${violation.description}\n`.red,
      `  Please check:`.red, `${violation.helpUrl}\n`.red,
      `  ${violation.nodes[0].failureSummary}`.red
    );
  } else {
    console.log(
      `
      ${name}
      `.cyan,
      '  All accessibility checks passed'.green
    );
  }
};

const getStorybook = async (browser, url) => {
  const page = await browser.newPage();

  await page.goto(url, {
    waitUntil: 'networkidle2'
  });

  const evaluate = await page.evaluate('__STORYBOOK_CLIENT_API__.getStorybook()');
  await page.close();

  return evaluate;
};

const getStories = async (browser, components) => {
  return components.map((component) => {
    const kind = component.kind;

    return component.stories.map((story) => {
      const name = story.name;
      return {
        url: `${localhost}?selectedKind=${kind}&selectedStory=${name}`,
        kind,
        name
      };
    })
  });
};

(async () => {
  const browser = await puppeteer.launch({args: opts, executablePath: getChromePath()}).catch((e) => unknownError(e));
  const components = await getStorybook(browser, localhost).catch((e) => unknownError(e));
  const stories = await getStories(browser, components);
  let errors = [];

  await browser.close();

  const cluster = await Cluster.launch({
    concurrency: Cluster.CONCURRENCY_CONTEXT,
    maxConcurrency: 10,
    puppeteerOptions: {
      executablePath: getChromePath()
    },
    puppeteer
  });

  const allStories = stories.reduce((all, value) => {
    return all.concat(value);
  }, []);

  await cluster.task(async ({ page, data }) => {
    const {url} = data;

    try {

      await page.goto(url, {waitUntil:  'networkidle2'});

      const handle = await page.evaluateHandle(`
        const wrapper = document.getElementById('root');
    		${axeCore.source}
    		axe.run(wrapper)
    	`);

      const results = await handle.jsonValue();

      console.log(JSON.stringify(results));

      await handle.dispose();
      await page.close();

      if (results.violations.length < 1) {
        logger(data);
      }

      results.violations.forEach((violation) => {
        errors.push(violation);
        logger(data, violation);
      });

    } catch (err) {
      throw err;
    }
  });

  for (const storyObj of allStories) {
    cluster.queue(storyObj);
  }

  await cluster.idle();
  await cluster.close();

  if (errors.length > 0) {
    console.error(`\n${errors.length} accessibility tests failed`.underline.red);
    core.setFailed(`${errors.length} accessibility tests failed`);
    process.exit(1);
  } else {
    console.log(`\nAll accessibility tests passed`.underline.green);
    process.exit(0);
  }
})();
