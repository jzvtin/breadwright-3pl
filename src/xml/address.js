/**
 * src/xml/address.js
 * Shared <Address> block builder. The samples used slightly different field
 * sets for billing vs shipping; this covers both via options.
 */
const { el } = require('./util');

/**
 * @param {object} a  address fields
 * @param {object} opts
 *   opts.role        'billing' | 'shipping'
 *   opts.orderAddress  value for <OrderAddress> (billing only), e.g. 'true'
 *   opts.placeIn      value for <PlaceIn> (shipping only), e.g. 'ShipTo'
 */
function addressBlock(a, opts = {}) {
  const children = [];

  if (opts.orderAddress != null) children.push(el('OrderAddress', opts.orderAddress));
  if (opts.placeIn != null) children.push(el('PlaceIn', opts.placeIn));

  children.push(el('AccountType', opts.role === 'shipping' ? 'Shipping' : 'Customer'));
  children.push(el('AccountName', a.accountName));
  children.push(el('AccountLookupCode', a.accountLookupCode));
  children.push(el('ContactTypeName', opts.role === 'shipping' ? 'Shipping' : 'Billing'));
  children.push(el('ContactPrimaryTelephone', a.telephone || ''));
  children.push(el('AddressLine1', a.addressLine1 || ''));
  if (a.addressLine2 != null && a.addressLine2 !== '') {
    children.push(el('AddressLine2', a.addressLine2));
  }
  children.push(el('AddressCity', a.city || ''));
  children.push(el('AddressState', a.state || ''));
  children.push(el('AddressPostalCode', a.postalCode || ''));
  // Empty country renders as <AddressCountry/> like the sample.
  children.push(el('AddressCountry', a.country ? a.country : null));

  return el('Address', children);
}

module.exports = { addressBlock };
