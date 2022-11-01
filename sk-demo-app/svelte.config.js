import {adapter} from 'sveltekit-adapter-aws';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: adapter({
            autoDeploy: true
        })
	}
};

export default config;
