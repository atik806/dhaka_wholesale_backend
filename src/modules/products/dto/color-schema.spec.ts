import { CreateProductSchema } from './create-product.dto';
import { UpdateProductSchema } from './update-product.dto';

const IMAGE = 'https://example.com/purple.jpg';

describe.each([
  ['create', CreateProductSchema.shape.colors],
  ['update', UpdateProductSchema.shape.colors],
])('%s product colours', (_, schema) => {
  it('keeps the photo linked to a colour', () => {
    expect(
      schema.parse([{ name: 'Purple', hex: '#9b8ac4', image: IMAGE }]),
    ).toEqual([{ name: 'Purple', hex: '#9b8ac4', image: IMAGE }]);
  });

  it('accepts colours without a photo', () => {
    expect(schema.parse([{ name: 'Red', hex: '#d7262e' }])).toEqual([
      { name: 'Red', hex: '#d7262e' },
    ]);
  });

  it('drops an invalid photo without losing the colours', () => {
    expect(
      schema.parse([{ name: 'Red', hex: '#d7262e', image: 'not a url' }]),
    ).toEqual([{ name: 'Red', hex: '#d7262e' }]);
  });
});
