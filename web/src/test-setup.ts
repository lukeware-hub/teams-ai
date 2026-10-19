import '@testing-library/dom';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// Under load a waitFor or findBy needs more than the default second.
configure({ asyncUtilTimeout: 5000 });
afterEach(cleanup);
