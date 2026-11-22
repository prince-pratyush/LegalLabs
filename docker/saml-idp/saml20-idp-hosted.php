<?php
// Fixed entity ID so it does not depend on the Host header the caller used
// (Zitadel reaches us as saml-idp:8080, the test harness through a published port).
$metadata['http://saml-idp:8080/idp'] = array(
    'host' => '__DEFAULT__',
    'privatekey' => 'server.pem',
    'certificate' => 'server.crt',
    'auth' => 'example-userpass',
    'signature.algorithm' => 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
);
