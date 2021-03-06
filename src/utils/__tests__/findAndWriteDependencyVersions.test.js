/* eslint-env jest */

import moduleUtils from '../findAndWriteDependencyVersions';

it('finds all imported modules', () => {
  const code = `
    import base64 from 'base64'; // 1.2.3
    import debounce from 'lodash/debounce'; // 2.3.4
    import { connect } from 'react-redux';
  `;

  const dependencies = moduleUtils.findModuleDependencies(code);

  expect(dependencies).toEqual({
    base64: '1.2.3',
    'lodash/debounce': '2.3.4',
    'react-redux': null,
  });
});

it('finds all required modules', () => {
  const code = `
    const base64 = require('base64'); // 1.2.3
    const debounce = require('lodash/debounce'); // 2.3.4
    const { connect } = require('react-redux');
  `;

  const dependencies = moduleUtils.findModuleDependencies(code);

  expect(dependencies).toEqual({
    base64: '1.2.3',
    'lodash/debounce': '2.3.4',
    'react-redux': null,
  });
});

it('finds all required modules with backticks', () => {
  const code = `
    const base64 = require(\`base64\`); // 1.2.3
    const debounce = require(\`lodash/debounce\`); // 2.3.4
    const { connect } = require(\`react-redux\`);
  `;

  const dependencies = moduleUtils.findModuleDependencies(code);

  expect(dependencies).toEqual({
    base64: '1.2.3',
    'lodash/debounce': '2.3.4',
    'react-redux': null,
  });
});

it('finds dependencies using all import styles', () => {
  const code = `
    import v from "mod1"; // 1.0.0
    import * as ns from "mod2"; // 2.0.0
    import {x} from "mod3"; // 3.0.0
    import {x as v} from "mod4"; // 4.0.0
    import "mod5"; // 5.0.0

    export {x} from "mod6"; // 6.0.0
    export {x as v} from "mod7"; // 7.0.0
    export * from "mod8"; // 8.0.0

    export default 7;
    export const value = 6;
    const otherValue = 5;
    export { otherValue }
  `;

  const dependencies = moduleUtils.findModuleDependencies(code);
  expect(dependencies).toEqual({
    mod1: '1.0.0',
    mod2: '2.0.0',
    mod3: '3.0.0',
    mod4: '4.0.0',
    mod5: '5.0.0',
    mod6: '6.0.0',
    mod7: '7.0.0',
    mod8: '8.0.0',
  });
});

it('writes dependency pins for all import styles', () => {
  const code = `
    import v from "mod1";
    import * as ns from "mod2";
    import {x} from "mod3";
    import {x as v} from "mod4";
    import "mod5";

    export {x} from "mod6";
    export {x as v} from "mod7";
    export * from "mod8";

    export default 7;
    export const value = 6;
    const otherValue = 5;
    export { otherValue }

  `;
  const modules = {
    mod1: '1.0.0',
    mod2: '2.0.0',
    mod3: '3.0.0',
    mod4: '4.0.0',
    mod5: '5.0.0',
    mod6: '6.0.0',
    mod7: '7.0.0',
    mod8: '8.0.0',
  };

  const finalCode = moduleUtils.writeModuleVersions(code, modules);
  expect(finalCode).toMatchSnapshot();
});

it("doesn't parse non-static and invalid requires", () => {
  const code = `
    const base64 = require();
    const debounce = require('debounce', null); // 2.3.4
    const moment = require(\`\${name}\`);
    const leftpad = require(\`left-\${name}\`);
    const core = require('/core');
    const promise = require('promise\\nme');
    const bluebird = require(\`blue
      bird
    \`);
    const { connect } = require(10);
  `;

  const dependencies = moduleUtils.findModuleDependencies(code);

  expect(dependencies).toEqual({});
});

it('writes versions for imported modules', () => {
  const code = `
    import base64 from 'base64';
    import debounce from 'lodash/debounce';
    import { connect } from 'react-redux';
  `;

  const modules = {
    base64: '1.2.3',
    'lodash/debounce': '2.3.4',
  };

  const dependencies = moduleUtils.writeModuleVersions(code, modules);

  expect(dependencies).toMatchSnapshot();
});

it('writes versions for required modules', () => {
  const code = `
    const base64 = require('base64');
    const debounce = require('lodash/debounce');
    const { connect } = require('react-redux');
  `;

  const modules = {
    base64: '1.2.3',
    'lodash/debounce': '2.3.4',
  };

  const dependencies = moduleUtils.writeModuleVersions(code, modules);

  expect(dependencies).toMatchSnapshot();
});

it('writes versions for required modules with backticks', () => {
  const code = `
    const base64 = require(\`base64\`);
    const debounce = require(\`lodash/debounce\`);
    const { connect } = require(\`react-redux\`);
  `;

  const modules = {
    base64: '1.2.3',
    'lodash/debounce': '2.3.4',
  };

  const dependencies = moduleUtils.writeModuleVersions(code, modules);

  expect(dependencies).toMatchSnapshot();
});
