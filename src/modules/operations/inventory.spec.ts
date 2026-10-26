import { variantStock } from '../../common/utils/commerce.js';
describe('variant inventory checks used by cart and quote', () => {
  const product = {
    stock_quantity: 10,
    stock: 'in-stock',
    inventory_mode: 'variant',
    inventory_variants: [
      { size: 'M', color: 'Red', stock_quantity: 2 },
      { size: 'L', color: 'Red', stock_quantity: 8 },
    ],
  };
  it('uses the selected SKU balance instead of the product total', () => {
    expect(variantStock(product, 'M', 'Red')).toBe(2);
  });
  it('does not substitute a different SKU when a choice is missing or unallocated', () => {
    expect(variantStock(product, 'XL', 'Red')).toBe(0);
    expect(variantStock(product)).toBe(0);
  });
  it('supports products that still use shared inventory', () => {
    expect(
      variantStock({ ...product, inventory_mode: 'product' }, 'M', 'Red'),
    ).toBe(10);
  });
});
