import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { RequestNotice } from './RequestNotice.js';

const show = (ready: boolean) =>
  render(
    <MemoryRouter>
      <RequestNotice projectId="shop" specId="shop-pedido-1" ready={ready} />
    </MemoryRouter>,
  );

describe('the notice of the open request on the project page', () => {
  it('says the agents are still preparing it and leads to the request', () => {
    show(false);
    expect(screen.getByTestId('request-notice').textContent).toContain('estão adicionando e preparando');
    expect(screen.getByTestId('request-notice').getAttribute('data-ready')).toBeNull();
    expect(screen.getByTestId('request-notice-link').getAttribute('href')).toBe('/refine/shop/shop-pedido-1');
  });

  it('says the request is concluded and only the start is left once the agents are done', () => {
    show(true);
    expect(screen.getByTestId('request-notice').textContent).toContain('Pedido concluído');
    expect(screen.getByTestId('request-notice').getAttribute('data-ready')).toBe('true');
    expect(screen.getByTestId('request-notice-link').textContent).toBe('Ver e iniciar');
  });
});
