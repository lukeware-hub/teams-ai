from app import handle, signer


def test_ac_001_hello_answers_200_with_the_message():
    status, body, signature = handle("/hello")
    assert (status, body) == (200, {"message": "hello"})
    assert signer.loads(signature) == body


def test_ac_002_health_answers_ok():
    assert handle("/health")[:2] == (200, {"status": "ok"})


def test_ac_003_unknown_path_answers_404():
    assert handle("/nope")[0] == 404
