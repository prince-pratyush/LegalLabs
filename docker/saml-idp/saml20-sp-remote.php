<?php
// SPs are written by scripts/zitadel-saml-bootstrap.mjs, because Zitadel only
// assigns its entity ID and ACS URL once the SAML provider has been created.
$file = '/sp-dynamic/sps.json';
$sps = is_readable($file) ? json_decode(file_get_contents($file), true) : array();
foreach ($sps as $entityId => $acs) {
    $metadata[$entityId] = array(
        'AssertionConsumerService' => $acs,
        'NameIDFormat' => 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        'simplesaml.nameidattribute' => 'email',
        'saml20.sign.assertion' => true,
        'saml20.sign.response' => true,
        'signature.algorithm' => 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    );
}
